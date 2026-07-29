import {
  listSessionListLookupActiveSessions,
  listSessionListLookupServerSessions,
} from '@/sync/domains/session/listing/sessionListLookupState';
import type { SessionMetadataLike } from '@/sync/domains/session/listing/sessionListLookupState';

import { normalizeNonEmptyString } from './shared';
import {
  resolveVoiceSessionLocationLabelFromMetadata,
  resolveVoiceSessionSharedTitleFromMetadata,
  resolveVoiceSessionTitleFromMetadata,
} from './sessionMetadata';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export type VoiceSessionRow = Readonly<{
  id: string;
  title: string | null;
  locationLabel?: string;
  updatedAt: number;
  active: boolean;
  presence: string | null;
  serverId?: string;
  serverName?: string;
}>;

type VoiceSessionRowDraft = {
  id: string;
  title: string | null;
  locationLabel?: string;
  updatedAt: number;
  active: boolean;
  presence: string | null;
  serverId?: string;
  serverName?: string;
  titleSourcePriority: number;
  locationSourcePriority: number;
  serverSourcePriority: number;
  statusSourcePriority: number;
};

function mergeVoiceSessionRow(
  existing: VoiceSessionRowDraft | undefined,
  next: VoiceSessionRowDraft,
): VoiceSessionRowDraft {
  if (!existing) {
    return next;
  }

  const merged: VoiceSessionRowDraft = {
    ...existing,
    updatedAt: Math.max(existing.updatedAt, next.updatedAt),
  };

  if (next.title) {
    const shouldUseTitle =
      !existing.title
      || next.titleSourcePriority > existing.titleSourcePriority
      || (
        next.titleSourcePriority === existing.titleSourcePriority
        && next.updatedAt >= existing.updatedAt
      );
    if (shouldUseTitle) {
      merged.title = next.title;
      merged.titleSourcePriority = next.titleSourcePriority;
    }
  }

  if (next.locationLabel) {
    const shouldUseLocation =
      !existing.locationLabel
      || next.locationSourcePriority > existing.locationSourcePriority
      || (
        next.locationSourcePriority === existing.locationSourcePriority
        && next.updatedAt >= existing.updatedAt
      );
    if (shouldUseLocation) {
      merged.locationLabel = next.locationLabel;
      merged.locationSourcePriority = next.locationSourcePriority;
    }
  }

  const nextServerId = normalizeNonEmptyString(next.serverId);
  const nextServerName = normalizeNonEmptyString(next.serverName);
  if (nextServerId || nextServerName) {
    const shouldUseServer =
      next.serverSourcePriority > existing.serverSourcePriority
      || (
        next.serverSourcePriority === existing.serverSourcePriority
        && next.updatedAt >= existing.updatedAt
      );
    if (shouldUseServer) {
      merged.serverId = nextServerId ?? undefined;
      merged.serverName = nextServerName ?? undefined;
      merged.serverSourcePriority = next.serverSourcePriority;
    }
  }

  const shouldUseStatus =
    next.statusSourcePriority > existing.statusSourcePriority
    || (
      next.statusSourcePriority === existing.statusSourcePriority
      && next.updatedAt >= existing.updatedAt
    );
  if (shouldUseStatus) {
    merged.active = next.active;
    merged.presence = next.presence;
    merged.statusSourcePriority = next.statusSourcePriority;
  }

  return merged;
}

function toVoiceSessionRowDraft(
  state: unknown,
  session: unknown,
  sourcePriority: number,
  options?: Readonly<{ serverId?: string | null; serverName?: string | null }>,
): VoiceSessionRowDraft | null {
  const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
  const id = normalizeNonEmptyString(record?.id);
  if (!id) return null;
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, id);
  const locationLabel = resolveVoiceSessionLocationLabelFromMetadata(ownerMetadata);
  return {
    id,
    title: resolveVoiceSessionSharedTitleFromMetadata(record?.metadata as SessionMetadataLike)
      ?? resolveVoiceSessionTitleFromMetadata(ownerMetadata),
    ...(locationLabel ? { locationLabel } : {}),
    updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : 0,
    active: Boolean(record?.active),
    presence: typeof record?.presence === 'string' ? record.presence : null,
    ...(normalizeNonEmptyString(options?.serverId) ? { serverId: normalizeNonEmptyString(options?.serverId)! } : {}),
    ...(normalizeNonEmptyString(options?.serverName) ? { serverName: normalizeNonEmptyString(options?.serverName)! } : {}),
    titleSourcePriority: sourcePriority,
    locationSourcePriority: sourcePriority,
    serverSourcePriority: sourcePriority,
    statusSourcePriority: sourcePriority,
  };
}

export function collectVoiceSessionRows(state: unknown): readonly VoiceSessionRow[] {
  const stateRecord = state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  const sessions = stateRecord?.sessions && typeof stateRecord.sessions === 'object'
    ? (stateRecord.sessions as Record<string, unknown>)
    : null;
  const rows = new Map<string, VoiceSessionRowDraft>();

  const pushRow = (session: unknown, sourcePriority: number, options?: Readonly<{ serverId?: string | null; serverName?: string | null }>) => {
    const next = toVoiceSessionRowDraft(state, session, sourcePriority, options);
    if (!next) return;
    rows.set(next.id, mergeVoiceSessionRow(rows.get(next.id), next));
  };

  if (sessions) {
    for (const session of Object.values(sessions)) {
      pushRow(session, 0);
    }
  }

  for (const entry of listSessionListLookupServerSessions(stateRecord)) {
    pushRow(entry.session, 1, {
      serverId: entry.serverId,
      serverName: entry.serverName,
    });
  }

  for (const entry of listSessionListLookupActiveSessions(stateRecord)) {
    pushRow(entry.session, 2, {
      serverId: entry.serverId,
      serverName: entry.serverName,
    });
  }

  return Array.from(rows.values())
    .map((row): VoiceSessionRow => ({
      id: row.id,
      title: row.title,
      ...(row.locationLabel ? { locationLabel: row.locationLabel } : {}),
      updatedAt: row.updatedAt,
      active: row.active,
      presence: row.presence,
      ...(row.serverId ? { serverId: row.serverId } : {}),
      ...(row.serverName ? { serverName: row.serverName } : {}),
    }))
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
      return left.id.localeCompare(right.id);
    });
}

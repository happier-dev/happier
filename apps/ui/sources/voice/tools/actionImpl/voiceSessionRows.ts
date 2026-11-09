import {
  findSessionListLookupSession,
  listSessionListLookupActiveSessions,
  listSessionListLookupServerSessions,
  type SessionListLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionMetadataLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { normalizeNonEmptyString } from './shared';
import {
  resolveVoiceSessionLocationLabelFromMetadata,
  resolveVoiceSessionSharedTitleFromMetadata,
  resolveVoiceSessionTitleFromMetadata,
} from './sessionMetadata';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import {
  normalizeSessionAddress,
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

export type VoiceSessionRow = Readonly<{
  /** Canonical cross-Home identity. `id` remains the Home-local session id. */
  address: SessionAddress;
  id: string;
  title: string | null;
  locationLabel?: string;
  updatedAt: number;
  active: boolean;
  presence: string | null;
  serverId: string;
  serverName?: string;
}>;

/**
 * Whether this collection saw every Home it knows about. Voice reference
 * resolution may never call a single match unique while coverage is partial.
 */
export type VoiceSessionCorpusCoverage = Readonly<{
  complete: boolean;
  /** Known Homes that contributed no session corpus to this collection. */
  uncoveredServerIds: readonly string[];
  /** A local session whose Home could not be determined was skipped. */
  hasUnqualifiedSessions: boolean;
}>;

export type VoiceSessionCorpus = Readonly<{
  rows: readonly VoiceSessionRow[];
  coverage: VoiceSessionCorpusCoverage;
}>;

export type VoiceSessionCorpusOptions = Readonly<{
  /** Home that owns unqualified `state.sessions` rows, when one is connected. */
  activeServerId?: string | null;
  /** Selected Homes whose candidates may participate in this resolution. */
  knownServerIds?: readonly string[];
  /** Supplied only by a producer that can prove the selected corpus is exhausted. */
  coverage?: 'complete' | 'incomplete';
  /** Exact membership supplied by that same mounted corpus owner. */
  addresses?: readonly SessionAddress[];
}>;

type VoiceSessionRowDraft = {
  address: SessionAddress;
  id: string;
  title: string | null;
  locationLabel?: string;
  updatedAt: number;
  active: boolean;
  presence: string | null;
  serverId: string;
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

  // Merging is keyed by the qualified address, so `serverId` can never change
  // here; only the human-facing Home label can improve.
  const nextServerName = normalizeNonEmptyString(next.serverName);
  if (nextServerName) {
    const shouldUseServer =
      next.serverSourcePriority > existing.serverSourcePriority
      || (
        next.serverSourcePriority === existing.serverSourcePriority
        && next.updatedAt >= existing.updatedAt
      );
    if (shouldUseServer) {
      merged.serverName = nextServerName;
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
  options?: Readonly<{ serverId?: string | null; serverName?: string | null; activeServerId?: string | null }>,
): VoiceSessionRowDraft | null {
  const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
  const id = normalizeNonEmptyString(record?.id);
  if (!id) return null;
  const address = normalizeSessionAddress(
    normalizeNonEmptyString(options?.serverId) ?? normalizeNonEmptyString(record?.serverId),
    id,
  );
  // A session whose Home cannot be determined is not addressable, so it cannot
  // participate in cross-Home resolution. The caller records the gap instead.
  if (!address) return null;
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, address, {
    activeServerId: options?.activeServerId,
  });
  const locationLabel = resolveVoiceSessionLocationLabelFromMetadata(ownerMetadata);
  return {
    address,
    id,
    title: resolveVoiceSessionSharedTitleFromMetadata(record?.metadata as SessionMetadataLike)
      ?? resolveVoiceSessionTitleFromMetadata(ownerMetadata),
    ...(locationLabel ? { locationLabel } : {}),
    updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : 0,
    active: Boolean(record?.active),
    presence: typeof record?.presence === 'string' ? record.presence : null,
    serverId: address.serverId,
    ...(normalizeNonEmptyString(options?.serverName) ? { serverName: normalizeNonEmptyString(options?.serverName)! } : {}),
    titleSourcePriority: sourcePriority,
    locationSourcePriority: sourcePriority,
    serverSourcePriority: sourcePriority,
    statusSourcePriority: sourcePriority,
  };
}

function isUserFacingVoiceSession(
  state: SessionListLookupStateLike,
  session: unknown,
  address: SessionAddress,
  options?: Readonly<{ activeServerId?: string | null }>,
): boolean {
  const record = session && typeof session === 'object' ? session as Record<string, unknown> : null;
  const metadataLayoutVersion = readSessionMetadataLayoutVersion(record?.metadataLayoutVersion);
  const listRow = readSessionListRowForServerId(state?.sessionListRowsByServerId, address.serverId, address.sessionId);
  // Visibility uses the admitted compact owner projection; execution still needs the full owner view.
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, address, options)
    ?? (listRow ? readSessionListRenderableOwnerMetadataView(listRow) : null);
  return isUserFacingSession({
    metadata: metadataLayoutVersion === 1 ? record?.metadata : ownerMetadata,
    ownerMetadataView: metadataLayoutVersion === 1 ? ownerMetadata : undefined,
    metadataLayoutVersion,
    access: record?.access as NormalizedSessionAccessProjection | null | undefined,
    accessLevel: record?.accessLevel,
    metadataUnavailable: record?.metadataUnavailable === true
      || (metadataLayoutVersion === 1 && ownerMetadata === null),
  });
}

/**
 * One qualified Voice session corpus plus its honest coverage. Rows are keyed
 * by `{serverId, sessionId}`, so two Homes holding the same Session ID stay two
 * distinct candidates instead of silently merging into one.
 */
export function collectVoiceSessionCorpus(
  state: unknown,
  options?: VoiceSessionCorpusOptions,
): VoiceSessionCorpus {
  const stateRecord = state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  const sessions = stateRecord?.sessions && typeof stateRecord.sessions === 'object'
    ? (stateRecord.sessions as Record<string, unknown>)
    : null;
  const activeServerId = normalizeNonEmptyString(options?.activeServerId)
    ?? normalizeNonEmptyString(getActiveServerSnapshot().serverId)
    ?? null;
  const selectedServerIds = options?.knownServerIds
    ? new Set(options.knownServerIds.map(normalizeNonEmptyString).filter((id): id is string => Boolean(id)))
    : null;
  const authoritativeAddressKeys = options?.addresses
    ? new Set(options.addresses.map(sessionAddressKey))
    : null;
  const rows = new Map<string, VoiceSessionRowDraft>();
  // Presence of an explicit address collection proves that every selected Home
  // participated, even when its authoritative result is empty. Row hydration
  // is checked separately below and may still make coverage incomplete.
  const coveredServerIds = new Set(authoritativeAddressKeys ? selectedServerIds ?? [] : []);
  let hasUnqualifiedSessions = false;

  const pushRow = (session: unknown, sourcePriority: number, rowOptions?: Readonly<{ serverId?: string | null; serverName?: string | null }>) => {
    const next = toVoiceSessionRowDraft(state, session, sourcePriority, {
      ...rowOptions,
      activeServerId,
    });
    if (!next) {
      const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
      if (!authoritativeAddressKeys && normalizeNonEmptyString(record?.id)) hasUnqualifiedSessions = true;
      return;
    }
    if (authoritativeAddressKeys && !authoritativeAddressKeys.has(sessionAddressKey(next.address))) return;
    if (selectedServerIds && !selectedServerIds.has(next.address.serverId)) return;
    coveredServerIds.add(next.address.serverId);
    if (!isUserFacingVoiceSession(stateRecord, session, next.address, { activeServerId })) return;
    const key = sessionAddressKey(next.address);
    rows.set(key, mergeVoiceSessionRow(rows.get(key), next));
  };

  if (sessions) {
    for (const session of Object.values(sessions)) {
      pushRow(session, 0, { serverId: activeServerId });
    }
  }

  if (options?.addresses) {
    // An authoritative admitted membership is enumerated address by address through
    // the exact lookup: a row-only/query acquisition hydrates rows without publishing
    // ordinary membership, so the ordinary enumerators below would never reach them.
    for (const address of options.addresses) {
      const entry = findSessionListLookupSession(stateRecord, address, { activeServerId });
      if (!entry) continue;
      pushRow(entry.session, 1, {
        serverId: entry.serverId,
        serverName: entry.serverName,
      });
    }
  } else {
    for (const entry of listSessionListLookupServerSessions(stateRecord)) {
      pushRow(entry.session, 1, {
        serverId: entry.serverId,
        serverName: entry.serverName,
      });
    }

    for (const entry of listSessionListLookupActiveSessions(stateRecord, { activeServerId })) {
      pushRow(entry.session, 2, {
        serverId: entry.serverId,
        serverName: entry.serverName,
      });
    }
  }

  const uncoveredServerIds = (options?.knownServerIds ?? [])
    .map((serverId) => normalizeNonEmptyString(serverId))
    .filter((serverId): serverId is string => Boolean(serverId) && !coveredServerIds.has(serverId!))
    .filter((serverId, index, all) => all.indexOf(serverId) === index)
    .sort();
  const hasMissingAuthoritativeRows = authoritativeAddressKeys
    ? [...authoritativeAddressKeys].some((key) => !rows.has(key))
    : false;

  return {
    rows: Array.from(rows.values())
      .map((row): VoiceSessionRow => ({
        address: row.address,
        id: row.id,
        title: row.title,
        ...(row.locationLabel ? { locationLabel: row.locationLabel } : {}),
        updatedAt: row.updatedAt,
        active: row.active,
        presence: row.presence,
        serverId: row.serverId,
        ...(row.serverName ? { serverName: row.serverName } : {}),
      }))
      .sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
        if (left.id !== right.id) return left.id.localeCompare(right.id);
        return left.serverId.localeCompare(right.serverId);
      }),
    coverage: {
      complete: options?.coverage === 'complete'
        && !hasUnqualifiedSessions
        && !hasMissingAuthoritativeRows,
      uncoveredServerIds,
      hasUnqualifiedSessions,
    },
  };
}

export function collectVoiceSessionRows(
  state: unknown,
  options?: VoiceSessionCorpusOptions,
): readonly VoiceSessionRow[] {
  return collectVoiceSessionCorpus(state, options).rows;
}

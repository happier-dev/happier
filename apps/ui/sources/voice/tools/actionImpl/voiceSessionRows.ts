import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { normalizeNonEmptyString } from './shared';

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

function resolveVoiceSessionTitle(session: unknown): string | null {
  const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
  const metadata = record?.metadata && typeof record.metadata === 'object'
    ? (record.metadata as Record<string, unknown>)
    : null;
  const summary = metadata?.summary && typeof metadata.summary === 'object'
    ? (metadata.summary as Record<string, unknown>)
    : null;

  const path = normalizeNonEmptyString(metadata?.path);
  const pathLabel = path ? normalizeNonEmptyString(path.split('/').filter(Boolean).at(-1)) : null;

  return (
    normalizeNonEmptyString(summary?.text)
    ?? normalizeNonEmptyString(metadata?.summaryText)
    ?? normalizeNonEmptyString(metadata?.name)
    ?? pathLabel
  );
}

function resolveVoiceSessionLocationLabel(session: unknown): string | null {
  const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
  const metadata = record?.metadata && typeof record.metadata === 'object'
    ? (record.metadata as Record<string, unknown>)
    : null;
  const path = normalizeNonEmptyString(metadata?.path);
  if (!path) return null;

  const homeDir = normalizeNonEmptyString(metadata?.homeDir) ?? undefined;
  const displayPath = formatPathRelativeToHome(path, homeDir).trim();
  if (displayPath === '~') return '~';

  const withoutTrailingSlash = displayPath.replace(/\/+$/, '');
  const tail = withoutTrailingSlash.split('/').filter(Boolean).at(-1);
  return normalizeNonEmptyString(tail ?? withoutTrailingSlash);
}

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
  session: unknown,
  sourcePriority: number,
  options?: Readonly<{ serverId?: string | null; serverName?: string | null }>,
): VoiceSessionRowDraft | null {
  const record = session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
  const id = normalizeNonEmptyString(record?.id);
  if (!id) return null;
  const locationLabel = resolveVoiceSessionLocationLabel(record);
  return {
    id,
    title: resolveVoiceSessionTitle(record),
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
  const renderables = stateRecord?.sessionListRenderables && typeof stateRecord.sessionListRenderables === 'object'
    ? (stateRecord.sessionListRenderables as Record<string, unknown>)
    : null;
  const visibleSessionList = Array.isArray(stateRecord?.sessionListViewData)
    ? (stateRecord.sessionListViewData as unknown[])
    : null;
  const byServer = stateRecord?.sessionListViewDataByServerId && typeof stateRecord.sessionListViewDataByServerId === 'object'
    ? (stateRecord.sessionListViewDataByServerId as Record<string, unknown>)
    : null;

  const rows = new Map<string, VoiceSessionRowDraft>();

  const pushRow = (session: unknown, sourcePriority: number, options?: Readonly<{ serverId?: string | null; serverName?: string | null }>) => {
    const next = toVoiceSessionRowDraft(session, sourcePriority, options);
    if (!next) return;
    rows.set(next.id, mergeVoiceSessionRow(rows.get(next.id), next));
  };

  if (sessions) {
    for (const session of Object.values(sessions)) {
      pushRow(session, 0);
    }
  }

  if (renderables) {
    for (const session of Object.values(renderables)) {
      pushRow(session, 1);
    }
  }

  if (byServer) {
    for (const [serverIdRaw, items] of Object.entries(byServer)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
        pushRow(row?.session, 2, {
          serverId: serverIdRaw,
          serverName: normalizeNonEmptyString(row?.serverName),
        });
      }
    }
  }

  if (visibleSessionList) {
    for (const item of visibleSessionList) {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      pushRow(row?.session, 3, {
        serverId: normalizeNonEmptyString(row?.serverId),
        serverName: normalizeNonEmptyString(row?.serverName),
      });
    }
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

import type { DirectSessionCandidateV1 } from '@happier-dev/protocol';

function parseMaybeTimestampMs(value: unknown): number | null {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const num = Math.trunc(value);
    return num < 1_000_000_000_000 ? num * 1000 : num;
  }
  return null;
}

function pickTimestampMs(session: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const parsed = parseMaybeTimestampMs(session[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

export function parseOpenCodeSessionCandidate(value: unknown): DirectSessionCandidateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const id = typeof s.id === 'string' ? s.id.trim() : '';
  if (!id) return null;

  const titleRaw = typeof s.title === 'string' ? s.title.trim() : typeof s.name === 'string' ? s.name.trim() : '';
  const time = s.time && typeof s.time === 'object' && !Array.isArray(s.time) ? (s.time as Record<string, unknown>) : null;
  const createdAtMs =
    pickTimestampMs(s, ['createdAtMs', 'createdAt', 'created_at']) ??
    pickTimestampMs(time ?? {}, ['created', 'createdAt', 'created_at', 'createdAtMs']);
  const updatedAtMs =
    pickTimestampMs(s, ['updatedAtMs', 'updatedAt', 'updated_at', 'modifiedAtMs', 'modifiedAt', 'modified_at']) ??
    pickTimestampMs(time ?? {}, ['updated', 'updatedAt', 'updated_at', 'updatedAtMs', 'modified']);
  const updated = updatedAtMs ?? createdAtMs ?? 0;
  const directory =
    typeof s.directory === 'string'
      ? s.directory.trim()
      : typeof s.path === 'string'
        ? s.path.trim()
        : '';

  const archived = typeof s.archived === 'boolean' ? s.archived : undefined;
  return {
    remoteSessionId: id,
    ...(titleRaw ? { title: titleRaw } : {}),
    updatedAtMs: updated,
    ...(createdAtMs != null ? { createdAtMs } : {}),
    ...(directory ? { details: { path: directory } } : {}),
    ...(archived !== undefined ? { archived } : {}),
  };
}

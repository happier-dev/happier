import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Settings } from '@/sync/domains/settings/settings';

export type VoiceUpdatesPrefs = Readonly<{
  snippetsMaxMessages: number;
  shareRecentMessages: boolean;
  otherSessionsSnippetsMode: 'always' | 'never' | 'on_demand_only';
  includeUserMessagesInSnippets: boolean;
  shareToolNames: boolean;
  shareToolArgs: boolean;
  shareFilePaths: boolean;
}>;

export function resolveVoiceUpdatesPrefs(settings: Settings): VoiceUpdatesPrefs {
  const voice: any = (settings as any)?.voice ?? {};
  return {
    snippetsMaxMessages: voice?.ui?.updates?.snippetsMaxMessages ?? 3,
    shareRecentMessages: voice?.privacy?.shareRecentMessages !== false,
    otherSessionsSnippetsMode: voice?.ui?.updates?.otherSessionsSnippetsMode ?? 'on_demand_only',
    includeUserMessagesInSnippets: voice?.ui?.updates?.includeUserMessagesInSnippets === true,
    shareToolNames: voice?.privacy?.shareToolNames !== false,
    shareToolArgs: voice?.privacy?.shareToolArgs !== false,
    shareFilePaths: voice?.privacy?.shareFilePaths !== false,
  } as const;
}

export function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function redactFilePathsInString(value: string): string {
  // Conservative redaction for absolute paths (opt-out via privacy settings).
  return value
    .replace(/\/Users\/[^\s"'<>]+/g, '<path_redacted>')
    .replace(/\/home\/[^\s"'<>]+/g, '<path_redacted>')
    .replace(/\/tmp\/[^\s"'<>]+/g, '<path_redacted>')
    .replace(/[A-Za-z]:\\\\[^\s"'<>]+/g, '<path_redacted>')
    .replace(/\\\\\\\\[^\s"'<>]+/g, '<path_redacted>');
}

export function redactFilePathsDeep(input: unknown): unknown {
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 20) return value;
    if (typeof value === 'string') return redactFilePathsInString(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, depth + 1);
    }
    return out;
  };
  return walk(input, 0);
}

export type CursorKey = { updatedAt: number; id: string };

export function parseCursorKey(cursor: string | null | undefined): CursorKey | null {
  if (!cursor) return null;
  const parts = cursor.split(':');
  if (parts.length < 2) return null;
  const updatedAt = Number(parts[0]);
  const id = parts.slice(1).join(':');
  if (!Number.isFinite(updatedAt) || !id) return null;
  return { updatedAt, id };
}

export function formatCursorKey(key: CursorKey | null): string | null {
  if (!key) return null;
  return `${key.updatedAt}:${key.id}`;
}

export function compareSessionKeyDesc(a: CursorKey, b: CursorKey): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function shouldIncludeAfterCursor(key: CursorKey, cursor: CursorKey): boolean {
  // Return true when key sorts after cursor in a descending (updatedAt,id) ordering.
  // We want the "next page", i.e. keys strictly less than the cursor.
  if (key.updatedAt !== cursor.updatedAt) return key.updatedAt < cursor.updatedAt;
  return key.id < cursor.id;
}

export function toRoleAndText(
  message: Message,
  prefs: Readonly<{ shareToolNames: boolean; shareToolArgs?: boolean; shareFilePaths?: boolean }>,
): { role: 'assistant' | 'user' | 'tool' | null; text: string | null } {
  if (message.kind === 'agent-text') {
    const text = prefs.shareFilePaths === false ? redactFilePathsInString(message.text) : message.text;
    return { role: 'assistant', text };
  }
  if (message.kind === 'user-text') {
    const text = prefs.shareFilePaths === false ? redactFilePathsInString(message.text) : message.text;
    return { role: 'user', text };
  }
  if (message.kind === 'tool-call') {
    if (!prefs.shareToolNames) return { role: null, text: null };
    const desc = message.tool.description ? ` - ${message.tool.description}` : '';
    const base = `Tool: ${message.tool.name}${desc}`;
    if (!prefs.shareToolArgs) return { role: 'tool', text: base };
    const args = prefs.shareFilePaths === false ? redactFilePathsDeep(message.tool.input ?? null) : (message.tool.input ?? null);
    return { role: 'tool', text: `${base}\nArgs: ${JSON.stringify(args)}` };
  }
  return { role: null, text: null };
}


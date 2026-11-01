import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

function dedupeStrings(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

const sessionMcpSelectionFieldsSchema = lazySchema(() => z.object({
  v: z.literal(1).default(1),
  managedServersEnabled: z.boolean().default(true),
  happierToolsEnabled: z.boolean().optional(),
  forceIncludeServerIds: z.array(z.string().min(1)).default([]),
  forceExcludeServerIds: z.array(z.string().min(1)).default([]),
}));

function normalizeSelection(value: z.infer<typeof sessionMcpSelectionFieldsSchema>) {
  return {
    ...value,
    forceIncludeServerIds: dedupeStrings(value.forceIncludeServerIds),
    forceExcludeServerIds: dedupeStrings(value.forceExcludeServerIds),
  };
}

/** Authoring input rejects unsupported fields rather than silently enabling defaults. */
export const SessionMcpSelectionV1InputSchema = lazySchema(() =>
  sessionMcpSelectionFieldsSchema.strict().transform(normalizeSelection));

/** Stored metadata retains the tolerant V1 reader contract. */
export const SessionMcpSelectionV1Schema = lazySchema(() => z.preprocess(
  (raw) => !raw || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw,
  sessionMcpSelectionFieldsSchema,
).transform(normalizeSelection));

export type SessionMcpSelectionV1 = z.infer<typeof SessionMcpSelectionV1Schema>;

export const SessionMcpSelectionRestartRequiredV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  appliedSelection: SessionMcpSelectionV1Schema,
}));

export type SessionMcpSelectionRestartRequiredV1 = z.infer<typeof SessionMcpSelectionRestartRequiredV1Schema>;

function selectionBehaviorKey(selection: SessionMcpSelectionV1): string {
  const normalized = SessionMcpSelectionV1Schema.parse(selection);
  const forceExcludeServerIds = [...normalized.forceExcludeServerIds].sort();
  const excluded = new Set(forceExcludeServerIds);
  const forceIncludeServerIds = normalized.forceIncludeServerIds
    .filter((serverId) => !excluded.has(serverId))
    .sort();
  return JSON.stringify({
    managedServersEnabled: normalized.managedServersEnabled,
    happierToolsEnabled: normalized.happierToolsEnabled ?? true,
    forceIncludeServerIds,
    forceExcludeServerIds,
  });
}

/** Compares the effective selection policy; exclude wins over a redundant include. */
export function areSessionMcpSelectionsEquivalent(
  left: SessionMcpSelectionV1,
  right: SessionMcpSelectionV1,
): boolean {
  return selectionBehaviorKey(left) === selectionBehaviorKey(right);
}

export function parseSessionMcpSelectionV1Json(raw: string | null | undefined): SessionMcpSelectionV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    const selection = SessionMcpSelectionV1InputSchema.safeParse(parsed);
    return selection.success ? selection.data : null;
  } catch {
    return null;
  }
}

export function readSessionMcpSelectionV1FromMetadata(metadata: unknown): SessionMcpSelectionV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).mcpSelectionV1;
  if (raw === undefined) return null;
  const parsed = SessionMcpSelectionV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Session-start delivery policy; absence preserves the released built-in tools default. */
export function isSessionHappierToolsEnabled(metadata: unknown): boolean {
  return readSessionMcpSelectionV1FromMetadata(metadata)?.happierToolsEnabled !== false;
}

export function readSessionMcpSelectionRestartRequiredV1FromMetadata(
  metadata: unknown,
): SessionMcpSelectionRestartRequiredV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).mcpSelectionRestartRequiredV1;
  if (raw === undefined) return null;
  const parsed = SessionMcpSelectionRestartRequiredV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

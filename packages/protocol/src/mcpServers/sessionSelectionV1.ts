import { z } from 'zod';

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

export const SessionMcpSelectionV1Schema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    },
    z.object({
      v: z.literal(1).default(1),
      managedServersEnabled: z.boolean().default(true),
      forceIncludeServerIds: z.array(z.string().min(1)).default([]),
      forceExcludeServerIds: z.array(z.string().min(1)).default([]),
    }),
  )
  .transform((value) => ({
    ...value,
    forceIncludeServerIds: dedupeStrings(value.forceIncludeServerIds),
    forceExcludeServerIds: dedupeStrings(value.forceExcludeServerIds),
  }));

export type SessionMcpSelectionV1 = z.infer<typeof SessionMcpSelectionV1Schema>;

export const SessionMcpSelectionRestartRequiredV1Schema = z.object({
  v: z.literal(1),
  appliedSelection: SessionMcpSelectionV1Schema,
});

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
    const selection = SessionMcpSelectionV1Schema.safeParse(parsed);
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

export function readSessionMcpSelectionRestartRequiredV1FromMetadata(
  metadata: unknown,
): SessionMcpSelectionRestartRequiredV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).mcpSelectionRestartRequiredV1;
  if (raw === undefined) return null;
  const parsed = SessionMcpSelectionRestartRequiredV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
